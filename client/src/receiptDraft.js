// Receipt photos chosen in the import form, handed to the review page in memory.
// (File objects are too large to put in router history state reliably.)
const drafts = new Map();
let next = 1;

export function saveDraftPhotos(files) {
  const id = String(next++);
  drafts.set(id, files);
  return id;
}

export const takeDraftPhotos = (id) => drafts.get(id) ?? [];
