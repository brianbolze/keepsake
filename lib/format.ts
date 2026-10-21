// Small display helpers shared by the library and its dialogs.
export const safeMedia = (url?: string | null) =>
  typeof url === "string" &&
  /^\/media\/[a-f0-9]{64}\.(jpg|jpeg|png|webp|gif|avif|mp4|webm)$/.test(url)
    ? url
    : null;
export const dateText = (value?: string | null) => {
  if (!value || Number.isNaN(Date.parse(value))) return "Unknown date";
  const date = new Date(value);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
};
export const domain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Source";
  }
};
export const isX = (url: string) => /^(x|twitter)\.com$/.test(domain(url));
// Lead with the post's first sentence and follow with the rest, so the full
// source text is shown exactly once.
export const splitPost = (item: { text?: string; title?: string }) => {
  const text = (item.text || "").trim();
  if (!text) return { head: item.title || "Untitled save", rest: "" };
  // Single line breaks are unreliable on X (mentions render on their own line).
  for (const match of text.slice(0, 140).matchAll(/[.!?…](?=\s|$)|\n\n/g)) {
    if (match.index < 12) continue;
    let cut = match.index + (match[0] === "\n\n" ? 0 : 1);
    cut += text
      .slice(cut)
      .match(/^[\s\p{Extended_Pictographic}\u200d\ufe0f]*(?=\S|$)/u)![0]
      .trimEnd().length;
    return { head: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
  }
  return { head: text, rest: "" };
};
export const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);
export const vagueCategory = (name: string) =>
  /^(other|uncategorized)$/i.test(name);
