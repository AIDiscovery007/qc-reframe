/** Image numbers describe attachment order, independently of each image's role. */
export function orderedImageIds(subjectIds: string[], referenceIndex: number) {
  const ids = [...subjectIds];
  ids.splice(Math.min(referenceIndex, ids.length), 0, "reference");
  return ids;
}

export function moveImage(subjectIds: string[], referenceIndex: number, id: string, delta: number) {
  const ids = orderedImageIds(subjectIds, referenceIndex), index = ids.indexOf(id);
  if (index < 0 || index + delta < 0 || index + delta >= ids.length) return;
  [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
  return { subjectIds: ids.filter(id => id !== "reference"), referenceIndex: ids.indexOf("reference") };
}
