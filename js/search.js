export function normalizeSearchText(value) {
  return String(value ?? "").toLocaleLowerCase("ru").replaceAll("ё", "е").trim();
}

export function searchFoundation() {
  return [];
}
