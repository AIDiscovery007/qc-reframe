import type { MultiSubject } from "../../lib/types";
import ImagePreview from "./ImagePreview";

export default function MultiInputPreview({ image, subjects, referenceIndex = subjects.length }: { image?: string; subjects: MultiSubject[]; referenceIndex?: number }) {
  return <div className="fusion-board" aria-label="输入预览"><figure className="board-template">{image && <ImagePreview src={image} alt="参考模板预览" />}<figcaption>图 {referenceIndex + 1} · 参考模板</figcaption></figure>
    <div className="board-subjects">{subjects.map((item, index) => <figure key={item.id}>{item.subjectImage && <ImagePreview src={item.subjectImage} alt={`主体 ${index + 1} 预览`} />}<figcaption>图 {index + (index >= referenceIndex ? 2 : 1)} · {item.role}</figcaption></figure>)}</div>
  </div>;
}
