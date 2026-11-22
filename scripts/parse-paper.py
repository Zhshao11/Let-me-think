"""Docling worker. Writes durable parsed assets; stdout is diagnostic only."""
import argparse
import importlib.metadata
import json
from pathlib import Path


def parse(source, destination):
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    options = PdfPipelineOptions()
    options.do_ocr = False
    options.generate_page_images = True
    options.generate_picture_images = True
    options.images_scale = 1.5
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    result = converter.convert(source)
    document = result.document
    if len(document.export_to_markdown().strip()) < max(100, len(document.pages) * 100):
        options.do_ocr = True
        converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
        result = converter.convert(source)
        document = result.document
    status = str(result.status)
    if "SUCCESS" not in status.upper() or "PARTIAL" in status.upper():
        raise ValueError(f"Docling 未完整完成：{status}")
    chunks, section = [], ""
    for index, (item, _) in enumerate(document.iterate_items()):
        provenance = getattr(item, "prov", None)
        if not provenance:
            continue
        page = provenance[0].page_no
        label = str(getattr(getattr(item, "label", "text"), "value", getattr(item, "label", "text")))
        if label in ("page_header", "page_footer"):
            continue
        asset = None
        if label == "table":
            text = item.export_to_markdown(doc=document)
        elif label == "picture":
            text = item.caption_text(document) or "图片内容需核对原页，尚未进行图像语义分析。"
            image = item.get_image(document)
            if image:
                asset = f"figure-{index}.png"
                image.save(destination / asset)
        else:
            text = getattr(item, "text", "")
        if not text.strip():
            continue
        if label in ("title", "section_header"):
            section = text
        for offset in range(0, len(text), 7000):
            chunk_id = f"p{page}-b{index}" + (f"-{offset // 7000}" if len(text) > 7000 else "")
            chunks.append({"id": chunk_id, "page": page, "kind": label, "section": section,
                           "text": text[offset:offset + 7000], "asset": asset,
                           "bbox": provenance[0].bbox.model_dump()})
    pages = []
    for number, page in document.pages.items():
        filename = f"page-{number}.png"
        if page.image:
            page.image.pil_image.save(destination / filename)
        pages.append({"page": number, "asset": filename if page.image else None})
    if not chunks or sum(len(c["text"]) for c in chunks) < 100:
        raise ValueError("没有提取到足够的正文，不能标记为论文处理完成。")
    title = next((c["text"] for c in chunks if c["kind"] == "title"),
                 next((c["text"] for c in chunks if c["page"] == 1 and c["kind"] == "section_header"), Path(source).stem))
    import pypdfium2
    with pypdfium2.PdfDocument(source) as original:
        if len(original) != len(document.pages):
            raise ValueError("解析页数与原始 PDF 不一致，不能标记为完整处理。")
    data = {"title": title, "pageCount": len(document.pages), "parser": "docling-" + importlib.metadata.version("docling"),
            "pages": pages, "chunks": chunks, "limitations": ["公式、图片及表格的语义需要结合原页核对。"]}
    (destination / "document.json").write_text(json.dumps(document.export_to_dict(), ensure_ascii=False, default=str))
    (destination / "document.md").write_text(document.export_to_markdown())
    temporary = destination / "parsed.json.tmp"
    temporary.write_text(json.dumps(data, ensure_ascii=False))
    temporary.replace(destination / "parsed.json")
    print(json.dumps({"pages": len(document.pages), "blocks": len(chunks), "parser": data["parser"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("destination")
    args = parser.parse_args()
    parse(args.source, args.destination)
