"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";

export const options = {
  media: [
    ["all", "Any media"],
    ["image", "Images"],
    ["video", "Videos"],
    ["none", "No media"],
  ],
  added: [
    ["all", "Any time"],
    ["1", "Today"],
    ["3", "Past 3 days"],
    ["7", "Past week"],
    ["30", "Past month"],
  ],
  scope: [
    ["all", "All saves"],
    ["work", "Work"],
    ["personal", "Personal/Social"],
    ["unsorted", "Unsorted"],
  ],
  sort: [
    ["posted-new", "Newest post"],
    ["posted-old", "Oldest post"],
    ["recent", "Recently added"],
    ["oldest", "Oldest added"],
    ["title", "Title A–Z"],
  ],
  group: [
    ["none", "None"],
    ["scope", "Work / Personal"],
    ["category", "Category"],
    ["month", "Month added"],
    ["signal", "Save type"],
    ["folder", "X folder"],
  ],
};
export const optionName = (values: (string | number)[][], value: string) =>
  values.find(([key]) => key === value)?.[1] || value;
export function Picker({
  label,
  value,
  onChange,
  values,
  inline = false,
  bare = false,
  emptyValue,
  className = "",
  disabled = false,
}: {
  label: string;
  value: string;
  onChange?: (value: string | null) => void;
  values: (string | number)[][];
  inline?: boolean;
  bare?: boolean;
  emptyValue?: string;
  className?: string;
  disabled?: boolean;
}) {
  const select = (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} size={inline ? "sm" : "default"}>
        <span className="select-label">
          {inline && !bare && <span className="select-prefix">{label}</span>}
          {value !== emptyValue && optionName(values, value)}
        </span>
      </SelectTrigger>
      <SelectContent>
        {values.map(([key, name]) => (
          <SelectItem key={key} value={key}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  if (inline)
    return <div className={`picker picker-inline ${className}`}>{select}</div>;
  return (
    <label className="picker">
      <span>{label}</span>
      {select}
    </label>
  );
}
