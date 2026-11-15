//! Encrypted spaces on the relay (docs/E2EE_SPACES.md §7): the two contract
//! kinds — 4290 sealed space event, 4291 space key grant — are ordinary
//! h-tagged events. The relay has no code for them, and that is the point:
//! these tests pin that membership gating, read visibility and deletion treat
//! them exactly like chat, and that what is stored is the ciphertext that was
//! published, byte for byte.
//!
//! Two backends:
//!  - embedded SQLite over a real WebSocket (relay-native membership), always
//!    runs with `--features embedded`, needs no Postgres;
//!  - Postgres with a platform space (`app.space_members`), skipped with a
//!    warning when the test database is unreachable.

mod common;

use common::{sign_event, TestIdentity};

const SEALED: i32 = 4290;
const GRANT: i32 = 4291;

/// What a client would never want a relay to see.
const PLAINTEXT: &str = "attack at dawn";

/// Stand-in for a NIP-44 payload: opaque base64 that is NOT the plaintext.
/// (The relay never decrypts, so the tests need no real key.)
fn ciphertext(seed: u8) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    (0..216u16)
        .map(|i| ALPHABET[((i as u8).wrapping_mul(31).wrapping_add(seed) % 64) as usize] as char)
        .collect()
}

fn sealed(author: &TestIdentity, group: &str, seed: u8, created_at: i64) -> thewired_relay::nostr::event::Event {
    sign_event(
        author,
        SEALED,
        vec![vec!["h".into(), group.into()], vec!["epoch".into(), "00112233445566ff".into()]],
        &ciphertext(seed),
        created_at,
    )
}

/// A grant handing the key to `recipients`: one 3-element `p` tag each, the
/// third element being that member's wrapped key.
fn grant(
    author: &TestIdentity,
    group: &str,
    recipients: &[&TestIdentity],
    seed: u8,
    created_at: i64,
) -> thewired_relay::nostr::event::Event {
    let mut tags = vec![
        vec!["h".into(), group.into()],
        vec!["epoch".into(), "00112233445566ff".into()],
        vec!["eph".into(), "ab".repeat(32)],
    ];
    for r in recipients {
        tags.push(vec!["p".into(), r.pubkey.clone(), ciphertext(seed.wrapping_add(1))]);
    }
    sign_event(author, GRANT, tags, &ciphertext(seed), created_at)
}

// ── Embedded SQLite, real WebSocket ──────────────────────────────────────────

#[cfg(feature = "embedded")]
mod embedded {
    use super::*;
    use futures::{SinkExt, StreamExt};
    use std::time::Duration;
    use thewired_relay::db::{sqlite, Db};
    use thewired_relay::nostr::event::Event;
    use thewired_relay::server;
    use tokio::time::timeout;
    use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

    const T: Duration = Duration::from_secs(5);
    const GROUP: &str = "sealed-g1";

    fn now() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
    }

    /// One authenticated connection to the embedded relay.
    struct Client {
        ws: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
        n: u32,
    }

    impl Client {
        async fn frame(&mut self, typ: &str) -> Option<serde_json::Value> {
            loop {
                let msg = match timeout(T, self.ws.next()).await {
                    Ok(Some(Ok(m))) => m,
                    _ => return None,
                };
                if let Message::Text(t) = msg {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                        if v.get(0).and_then(|x| x.as_str()) == Some(typ) {
                            return Some(v);
                        }
                    }
                }
            }
        }

        /// Connect and, when `who` is given, answer the NIP-42 challenge as them.
        async fn connect(url: &str, who: Option<&TestIdentity>) -> Self {
            let (ws, _) = connect_async(url).await.expect("connect");
            let mut c = Client { ws, n: 0 };
            let auth = c.frame("AUTH").await.expect("AUTH challenge");
            if let Some(who) = who {
                let challenge = auth.get(1).and_then(|v| v.as_str()).unwrap().to_string();
                let ev = sign_event(
                    who,
                    22242,
                    vec![vec!["relay".into(), url.to_string()], vec!["challenge".into(), challenge]],
                    "",
                    now(),
                );
                c.ws.send(Message::Text(format!(r#"["AUTH",{}]"#, serde_json::to_string(&ev).unwrap()).into()))
                    .await
                    .unwrap();
                let ok = c.frame("OK").await.expect("OK for AUTH");
                assert_eq!(ok.get(2).and_then(|v| v.as_bool()), Some(true), "AUTH rejected: {ok}");
            }
            c
        }

        /// Publish and return `(accepted, message)`.
        async fn publish(&mut self, event: &Event) -> (bool, String) {
            self.ws
                .send(Message::Text(format!(r#"["EVENT",{}]"#, serde_json::to_string(event).unwrap()).into()))
                .await
                .unwrap();
            loop {
                let ok = self.frame("OK").await.expect("OK for EVENT");
                if ok.get(1).and_then(|v| v.as_str()) == Some(event.id.as_str()) {
                    return (
                        ok.get(2).and_then(|v| v.as_bool()).unwrap_or(false),
                        ok.get(3).and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                    );
                }
            }
        }

        /// Run one REQ to completion and return the stored events it served.
        async fn req(&mut self, filter: serde_json::Value) -> Vec<serde_json::Value> {
            self.n += 1;
            let sub = format!("q{}", self.n);
            self.ws.send(Message::Text(serde_json::json!(["REQ", sub, filter]).to_string().into())).await.unwrap();
            let mut out = Vec::new();
            loop {
                let msg = match timeout(T, self.ws.next()).await {
                    Ok(Some(Ok(Message::Text(t)))) => t,
                    Ok(Some(Ok(_))) => continue,
                    _ => panic!("REQ {sub} neither ended nor closed"),
                };
                let v: serde_json::Value = match serde_json::from_str(&msg) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if v.get(1).and_then(|x| x.as_str()) != Some(sub.as_str()) {
                    continue;
                }
                match v.get(0).and_then(|x| x.as_str()) {
                    Some("EVENT") => out.push(v.get(2).cloned().unwrap()),
                    Some("EOSE") | Some("CLOSED") => break,
                    _ => {}
                }
            }
            self.ws.send(Message::Text(serde_json::json!(["CLOSE", sub]).to_string().into())).await.unwrap();
            out
        }
    }

    fn ids(events: &[serde_json::Value]) -> Vec<String> {
        let mut out: Vec<String> =
            events.iter().map(|e| e.get("id").and_then(|v| v.as_str()).unwrap().to_string()).collect();
        out.sort();
        out
    }

    struct World {
        relay: server::EmbeddedRelay,
        db: Db,
        owner: TestIdentity,
        member: TestIdentity,
        stranger: TestIdentity,
    }

    /// An open relay-native group owned by `owner`; `member` has joined,
    /// `stranger` has not.
    async fn world() -> (World, Client, Client, Client) {
        let owner = TestIdentity::from_seed(41);
        let member = TestIdentity::from_seed(42);
        let stranger = TestIdentity::from_seed(43);
        let pool = sqlite::connect_memory().await.unwrap();
        let db = Db::Sqlite(pool.clone());
        let relay =
            server::run_embedded(Db::Sqlite(pool), 0, "sealed-test".to_string(), None, Some(owner.pubkey.clone()), false)
                .await
                .expect("embedded relay");
        let url = relay.ws_url().to_string();

        let mut o = Client::connect(&url, Some(&owner)).await;
        let mut m = Client::connect(&url, Some(&member)).await;
        let s = Client::connect(&url, Some(&stranger)).await;

        let create = sign_event(&owner, 9007, vec![vec!["h".into(), GROUP.into()]], "Sealed", 1_700_000_000);
        assert!(o.publish(&create).await.0, "9007");
        let join = sign_event(&member, 9021, vec![vec!["h".into(), GROUP.into()]], "", 1_700_000_001);
        assert!(m.publish(&join).await.0, "9021");

        (World { relay, db, owner, member, stranger }, o, m, s)
    }

    #[tokio::test]
    async fn members_publish_and_read_sealed_events_and_the_stored_row_is_the_ciphertext() {
        let (w, mut o, mut m, _s) = world().await;

        let from_owner = sealed(&w.owner, GROUP, 1, 1_700_000_010);
        let from_member = sealed(&w.member, GROUP, 2, 1_700_000_011);
        assert_eq!(o.publish(&from_owner).await, (true, String::new()));
        assert!(m.publish(&from_member).await.0);

        // Stored exactly as published: same content, same tags, nothing added.
        for ev in [&from_owner, &from_member] {
            let stored = w.db.get_event_by_id(&ev.id).await.unwrap().expect("stored");
            assert_eq!(stored.content, ev.content, "content is stored byte for byte");
            assert_eq!(stored.tags, ev.tags);
            assert_eq!(stored.kind, SEALED);
            assert_eq!(stored.pubkey, ev.pubkey);
            let raw = serde_json::to_string(&stored).unwrap();
            assert!(!raw.contains(PLAINTEXT), "no plaintext in the stored row");
        }

        // Both members read both events back.
        for c in [&mut o, &mut m] {
            let got = c.req(serde_json::json!({ "kinds": [SEALED], "#h": [GROUP] })).await;
            let mut want = vec![from_owner.id.clone(), from_member.id.clone()];
            want.sort();
            assert_eq!(ids(&got), want);
            for e in &got {
                let id = e.get("id").and_then(|v| v.as_str()).unwrap();
                let original = if id == from_owner.id { &from_owner } else { &from_member };
                assert_eq!(e.get("content").and_then(|v| v.as_str()), Some(original.content.as_str()));
            }
        }
        w.relay.stop().await;
    }

    #[tokio::test]
    async fn a_non_member_can_neither_publish_nor_read_either_kind() {
        let (w, mut o, _m, mut s) = world().await;

        let ev = sealed(&w.owner, GROUP, 3, 1_700_000_020);
        let g = grant(&w.owner, GROUP, &[&w.owner, &w.member], 4, 1_700_000_021);
        assert!(o.publish(&ev).await.0);
        assert!(o.publish(&g).await.0);

        for forged in [sealed(&w.stranger, GROUP, 5, 1_700_000_022), grant(&w.stranger, GROUP, &[&w.stranger], 6, 1_700_000_023)] {
            let (ok, msg) = s.publish(&forged).await;
            assert!(!ok, "a non-member's kind {} must be refused", forged.kind);
            assert!(msg.starts_with("auth-required: not a member"), "got: {msg}");
            assert!(w.db.get_event_by_id(&forged.id).await.unwrap().is_none(), "and not stored");
        }

        // Authenticated, but not a member and not a grant recipient: nothing.
        assert!(s.req(serde_json::json!({ "kinds": [SEALED, GRANT], "#h": [GROUP] })).await.is_empty());
        assert!(s.req(serde_json::json!({ "ids": [ev.id, g.id] })).await.is_empty());

        // Anonymous: nothing.
        let mut anon = Client::connect(&w.relay.ws_url(), None).await;
        assert!(anon.req(serde_json::json!({ "kinds": [SEALED, GRANT], "#h": [GROUP] })).await.is_empty());
        w.relay.stop().await;
    }

    #[tokio::test]
    async fn a_removed_member_is_cut_off_from_new_sealed_events_and_new_grants() {
        let (w, mut o, mut m, _s) = world().await;

        let old_grant = grant(&w.owner, GROUP, &[&w.owner, &w.member], 7, 1_700_000_030);
        let before = sealed(&w.owner, GROUP, 8, 1_700_000_031);
        assert!(o.publish(&old_grant).await.0);
        assert!(o.publish(&before).await.0);
        assert_eq!(m.req(serde_json::json!({ "kinds": [SEALED], "#h": [GROUP] })).await.len(), 1);

        // 9001: the owner removes the member, then rotates (a grant without them).
        let remove = sign_event(
            &w.owner,
            9001,
            vec![vec!["h".into(), GROUP.into()], vec!["p".into(), w.member.pubkey.clone()]],
            "",
            1_700_000_032,
        );
        assert!(o.publish(&remove).await.0, "9001");
        let new_grant = grant(&w.owner, GROUP, &[&w.owner], 9, 1_700_000_033);
        let after = sealed(&w.owner, GROUP, 10, 1_700_000_034);
        assert!(o.publish(&new_grant).await.0);
        assert!(o.publish(&after).await.0);

        // The removed member can no longer publish into the space…
        let (ok, msg) = m.publish(&sealed(&w.member, GROUP, 11, 1_700_000_035)).await;
        assert!(!ok && msg.starts_with("auth-required: not a member"), "got ok={ok} msg={msg}");

        // …nor read its sealed events, old or new, on a fresh connection.
        let mut again = Client::connect(&w.relay.ws_url(), Some(&w.member)).await;
        assert!(again.req(serde_json::json!({ "kinds": [SEALED], "#h": [GROUP] })).await.is_empty());
        assert!(again.req(serde_json::json!({ "ids": [after.id] })).await.is_empty());

        // The old grant names them in a `p` tag, so they can still fetch it (it
        // holds a key they already had). The new one does not name them.
        let grants = again.req(serde_json::json!({ "kinds": [GRANT], "#h": [GROUP] })).await;
        assert_eq!(ids(&grants), vec![old_grant.id.clone()]);

        // The owner still reads everything.
        assert_eq!(o.req(serde_json::json!({ "kinds": [SEALED], "#h": [GROUP] })).await.len(), 2);
        w.relay.stop().await;
    }

    #[tokio::test]
    async fn deletion_removes_the_stored_ciphertext() {
        let (w, mut o, mut m, _s) = world().await;

        let own = sealed(&w.member, GROUP, 12, 1_700_000_040);
        let moderated = sealed(&w.member, GROUP, 13, 1_700_000_041);
        assert!(m.publish(&own).await.0);
        assert!(m.publish(&moderated).await.0);

        // NIP-09: the author deletes their own sealed event.
        let del = sign_event(
            &w.member,
            5,
            vec![vec!["e".into(), own.id.clone()], vec!["k".into(), SEALED.to_string()], vec!["h".into(), GROUP.into()]],
            "",
            1_700_000_042,
        );
        assert!(m.publish(&del).await.0, "kind 5");
        assert!(w.db.get_event_by_id(&own.id).await.unwrap().is_none(), "ciphertext row is gone");

        // NIP-29 9005: an admin deletes another member's sealed event.
        let mod_del = sign_event(
            &w.owner,
            9005,
            vec![vec!["h".into(), GROUP.into()], vec!["e".into(), moderated.id.clone()]],
            "",
            1_700_000_043,
        );
        let (ok, msg) = o.publish(&mod_del).await;
        assert!(ok, "9005: {msg}");
        assert!(w.db.get_event_by_id(&moderated.id).await.unwrap().is_none());

        // And a deleted sealed event cannot be put back.
        let (ok, msg) = m.publish(&own).await;
        assert!(!ok && msg.starts_with("deleted:"), "got ok={ok} msg={msg}");
        assert!(o.req(serde_json::json!({ "kinds": [SEALED], "#h": [GROUP] })).await.is_empty());
        w.relay.stop().await;
    }

    #[tokio::test]
    async fn sealed_content_is_not_searchable() {
        let (w, mut o, _m, _s) = world().await;
        let ev = sealed(&w.owner, GROUP, 14, 1_700_000_050);
        assert!(o.publish(&ev).await.0);
        // NIP-50 over the space: the plaintext was never there to find.
        let hits = o.req(serde_json::json!({ "search": PLAINTEXT, "#h": [GROUP] })).await;
        assert!(hits.is_empty());
        w.relay.stop().await;
    }
}

// ── Postgres, platform space ─────────────────────────────────────────────────

mod postgres {
    use super::*;
    use common::{add_member, insert_platform_space, make_app_state, remove_member, send_event, setup_test_pool};
    use thewired_relay::nostr::filter::Filter;

    const SPACE: &str = "sealed-platform-space";

    fn parse_ok(value: &serde_json::Value) -> (bool, String) {
        assert_eq!(value.get(0).and_then(|v| v.as_str()), Some("OK"), "expected OK frame, got {value:?}");
        (
            value.get(2).and_then(|v| v.as_bool()).unwrap_or(false),
            value.get(3).and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        )
    }

    fn filter(v: serde_json::Value) -> Filter {
        serde_json::from_value(v).unwrap()
    }

    #[tokio::test]
    async fn platform_space_gates_and_stores_sealed_events_like_chat() {
        let pool = match setup_test_pool().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skip: {e}");
                return;
            }
        };
        let owner = TestIdentity::from_seed(51);
        let member = TestIdentity::from_seed(52);
        let stranger = TestIdentity::from_seed(53);
        sqlx::query("DELETE FROM relay.events WHERE h_tag = $1").bind(SPACE).execute(&pool).await.unwrap();
        insert_platform_space(&pool, SPACE, &owner.pubkey).await.unwrap();
        add_member(&pool, SPACE, &owner.pubkey).await.unwrap();
        add_member(&pool, SPACE, &member.pubkey).await.unwrap();
        let (state, tx) = make_app_state(pool.clone());

        let ev = sealed(&member, SPACE, 21, 1_700_000_100);
        let g = grant(&owner, SPACE, &[&owner, &member], 22, 1_700_000_101);
        assert_eq!(parse_ok(&send_event(&state, &tx, &ev).await), (true, String::new()));
        assert!(parse_ok(&send_event(&state, &tx, &g).await).0);

        // Stored byte for byte, with the h tag mirrored like any space event.
        let stored = state.pool.get_event_by_id(&ev.id).await.unwrap().expect("stored");
        assert_eq!(stored.content, ev.content);
        assert_eq!(stored.tags, ev.tags);
        let (h_tag, content): (Option<String>, String) =
            sqlx::query_as("SELECT h_tag, content FROM relay.events WHERE id = $1").bind(&ev.id).fetch_one(&pool).await.unwrap();
        assert_eq!(h_tag.as_deref(), Some(SPACE));
        assert_eq!(content, ev.content);
        assert!(!content.contains(PLAINTEXT));

        // A non-member is refused for both kinds.
        for forged in [sealed(&stranger, SPACE, 23, 1_700_000_102), grant(&stranger, SPACE, &[&stranger], 24, 1_700_000_103)] {
            let (ok, msg) = parse_ok(&send_event(&state, &tx, &forged).await);
            assert!(!ok && msg.starts_with("auth-required: not a member"), "kind {}: {msg}", forged.kind);
        }

        // Read: members only (and nobody anonymous).
        let q = filter(serde_json::json!({ "kinds": [SEALED, GRANT], "#h": [SPACE] }));
        assert_eq!(state.pool.query_events(&q, Some(&member.pubkey)).await.unwrap().len(), 2);
        assert!(state.pool.query_events(&q, Some(&stranger.pubkey)).await.unwrap().is_empty());
        assert!(state.pool.query_events(&q, None).await.unwrap().is_empty());

        // Removed from the space: no more publishing, no more reading others'
        // sealed events; the grant that names them stays fetchable.
        remove_member(&pool, SPACE, &member.pubkey).await.unwrap();
        let (ok, msg) = parse_ok(&send_event(&state, &tx, &sealed(&member, SPACE, 25, 1_700_000_104)).await);
        assert!(!ok && msg.starts_with("auth-required: not a member"), "got: {msg}");
        let from_owner = sealed(&owner, SPACE, 26, 1_700_000_105);
        assert!(parse_ok(&send_event(&state, &tx, &from_owner).await).0);
        let seen = state.pool.query_events(&q, Some(&member.pubkey)).await.unwrap();
        let seen_ids: Vec<&str> = seen.iter().map(|e| e.id.as_str()).collect();
        assert!(!seen_ids.contains(&from_owner.id.as_str()), "a removed member must not read new sealed events");
        assert!(seen_ids.contains(&g.id.as_str()), "the grant naming them is still theirs to fetch");
    }
}
