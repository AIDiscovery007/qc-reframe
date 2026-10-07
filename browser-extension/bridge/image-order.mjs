export function referencePosition(value, subjectCount, fallback = subjectCount) {
  const index = value === undefined ? fallback : value;
  if (!Number.isInteger(index) || index < 0 || index > subjectCount)
    throw Object.assign(new Error("参考图顺序无效，请重新调整图片顺序"), { status: 400 });
  return index;
}

export function savedReferenceIndex(record) {
  return referencePosition(record.referenceIndex, record.subjects?.length ?? record.reenact?.subjects?.length ?? (record.subjectAsset || record.subjectExtension || record.reenact ? 1 : 0));
}

export function orderedImages(imagePath, subjectPaths, value) {
  const referenceIndex = referencePosition(value, subjectPaths.length);
  const paths = [...subjectPaths];
  if (imagePath) paths.splice(referenceIndex, 0, imagePath);
  return { paths, referenceIndex, subjectNumbers: subjectPaths.map((_, index) => index + 1 + Number(index >= referenceIndex)) };
}
