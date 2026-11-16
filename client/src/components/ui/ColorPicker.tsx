import { useState, useCallback, useId } from "react";
import { parseHSL, toHSLString } from "../../lib/themeEngine";

interface ColorPickerProps {
  label: string;
  value: string; // HSL string e.g. "220 14% 8%"
  onChange: (hsl: string) => void;
}

export function ColorPicker({ label, value, onChange }: ColorPickerProps) {
  const hsl = parseHSL(value);
  const [h, setH] = useState(hsl.h);
  const [s, setS] = useState(hsl.s);
  const [l, setL] = useState(hsl.l);

  const commit = useCallback(
    (nh: number, ns: number, nl: number) => {
      onChange(toHSLString({ h: nh, s: ns, l: nl }));
    },
    [onChange],
  );

  const previewColor = `hsl(${h}, ${s}%, ${l}%)`;
  const id = useId();
  const labelId = `${id}-label`;

  return (
    <div role="group" aria-labelledby={labelId} className="space-y-2">
      <div className="flex items-center gap-2">
        <div
          aria-hidden="true"
          className="h-6 w-6 rounded-md border border-border"
          style={{ backgroundColor: previewColor }}
        />
        <span id={labelId} className="text-xs font-medium text-heading">{label}</span>
        <span className="ml-auto text-[10px] font-mono text-muted">
          {Math.round(h)} {Math.round(s)}% {Math.round(l)}%
        </span>
      </div>

      {/* Hue */}
      <div className="space-y-0.5">
        <label htmlFor={`${id}-hue`} className="text-[10px] text-muted">Hue</label>
        <input
          id={`${id}-hue`}
          type="range"
          aria-valuetext={`${Math.round(h)}°`}
          min={0}
          max={360}
          value={h}
          onChange={(e) => {
            const v = Number(e.target.value);
            setH(v);
            commit(v, s, l);
          }}
          className="w-full accent-[var(--color-primary)]"
        />
      </div>

      {/* Saturation */}
      <div className="space-y-0.5">
        <label htmlFor={`${id}-saturation`} className="text-[10px] text-muted">Saturation</label>
        <input
          id={`${id}-saturation`}
          type="range"
          aria-valuetext={`${Math.round(s)}%`}
          min={0}
          max={100}
          value={s}
          onChange={(e) => {
            const v = Number(e.target.value);
            setS(v);
            commit(h, v, l);
          }}
          className="w-full accent-[var(--color-primary)]"
        />
      </div>

      {/* Lightness */}
      <div className="space-y-0.5">
        <label htmlFor={`${id}-lightness`} className="text-[10px] text-muted">Lightness</label>
        <input
          id={`${id}-lightness`}
          type="range"
          aria-valuetext={`${Math.round(l)}%`}
          min={0}
          max={100}
          value={l}
          onChange={(e) => {
            const v = Number(e.target.value);
            setL(v);
            commit(h, s, v);
          }}
          className="w-full accent-[var(--color-primary)]"
        />
      </div>
    </div>
  );
}
