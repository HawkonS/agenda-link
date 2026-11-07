import PinyinMatch from "pinyin-match";

export function matchesPeopleSearch(label: string, query: string): boolean {
  const keyword = query.normalize("NFKC").trim().toLowerCase();
  if (!keyword) return true;
  const text = label.normalize("NFKC").toLowerCase();
  return text.includes(keyword) || !!PinyinMatch.match(text, keyword);
}
