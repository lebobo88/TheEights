interface SearchBoxProps {
  value: string;
  onChange: (q: string) => void;
  onEnter: (q: string) => void;
  onReset: () => void;
}

export function SearchBox({ value, onChange, onEnter, onReset }: SearchBoxProps): JSX.Element {
  return (
    <div className="ov controls">
      <div className="search-wrap">
        <input
          id="search"
          placeholder="search modules…"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter(value.trim());
          }}
        />
      </div>
      <button className="btn" id="reset" onClick={onReset}>
        reset view
      </button>
    </div>
  );
}
