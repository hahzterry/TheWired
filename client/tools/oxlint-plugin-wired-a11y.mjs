/**
 * Local accessibility rules for oxlint (loaded through `jsPlugins`).
 *
 * `icon-button-has-name`: a <button> (or an element with role="button") whose
 * only content is an icon has no accessible name unless it carries
 * `aria-label`, `aria-labelledby` or `title`. The stock
 * `jsx-a11y/control-has-associated-label` rule cannot see this: it gives any
 * child component the benefit of the doubt, and an icon is a component.
 *
 * "Icon" means a self-closing component imported from lucide-react. (An inline
 * <svg> is plain DOM, which the stock rule already catches.) Elements with a
 * spread attribute are skipped, because the label may arrive through the
 * spread.
 */

const ICON_SOURCES = new Set(["lucide-react"]);
const NAMING_ATTRIBUTES = new Set(["aria-label", "aria-labelledby", "title"]);

function attributeName(attr) {
  if (attr.type !== "JSXAttribute") return null;
  return attr.name.type === "JSXNamespacedName"
    ? `${attr.name.namespace.name}:${attr.name.name.name}`
    : attr.name.name;
}

function elementName(node) {
  const name = node.openingElement.name;
  return name.type === "JSXIdentifier" ? name.name : null;
}

function staticAttributeValue(attr) {
  if (!attr.value) return true;
  if (attr.value.type === "Literal") return attr.value.value;
  if (attr.value.type === "JSXExpressionContainer" && attr.value.expression.type === "Literal") {
    return attr.value.expression.value;
  }
  return undefined;
}

/** true = certainly an icon, false = anything else (text, unknown component…). */
function isIconOnly(node, icons) {
  switch (node.type) {
    case "JSXElement": {
      const name = elementName(node);
      return name !== null && icons.has(name) && node.children.length === 0;
    }
    case "JSXFragment":
      return childrenAreIconOnly(node.children, icons);
    case "JSXExpressionContainer":
      return isIconOnly(node.expression, icons);
    case "ConditionalExpression":
      return isIconOnly(node.consequent, icons) && isIconOnly(node.alternate, icons);
    case "LogicalExpression":
      return isIconOnly(node.right, icons);
    default:
      return false;
  }
}

function childrenAreIconOnly(children, icons) {
  const meaningful = children.filter(
    (child) =>
      !(child.type === "JSXText" && child.value.trim() === "") &&
      !(child.type === "JSXExpressionContainer" && child.expression.type === "JSXEmptyExpression"),
  );
  return meaningful.length > 0 && meaningful.every((child) => isIconOnly(child, icons));
}

const iconButtonHasName = {
  meta: {
    type: "problem",
    docs: { description: "Icon-only buttons need an accessible name." },
    messages: {
      missingName:
        "Icon-only button has no accessible name. Add `aria-label` (or `aria-labelledby` / `title`).",
    },
    schema: [],
  },
  create(context) {
    const icons = new Set();
    return {
      ImportDeclaration(node) {
        if (!ICON_SOURCES.has(node.source.value)) return;
        for (const spec of node.specifiers) icons.add(spec.local.name);
      },
      JSXElement(node) {
        const attributes = node.openingElement.attributes;
        if (attributes.some((attr) => attr.type === "JSXSpreadAttribute")) return;

        const byName = new Map();
        for (const attr of attributes) byName.set(attributeName(attr), attr);

        const role = byName.get("role");
        const isButton =
          elementName(node) === "button" || (role && staticAttributeValue(role) === "button");
        if (!isButton) return;
        if ([...NAMING_ATTRIBUTES].some((name) => byName.has(name))) return;
        if (!childrenAreIconOnly(node.children, icons)) return;

        context.report({ node: node.openingElement, messageId: "missingName" });
      },
    };
  },
};

export default {
  meta: { name: "wired-a11y" },
  rules: { "icon-button-has-name": iconButtonHasName },
};
