// Field coordinates are normalized against the page displayed by PDF.js.
// Convert that display plane back to PDF coordinates, including CropBox/Rotate.
export function fieldPlacement(page, field) {
  const media = page.getMediaBox(), crop = page.getCropBox();
  const left = Math.max(media.x, crop.x), bottom = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);
  const box = right > left && top > bottom ? { x: left, y: bottom, width: right-left, height: top-bottom } : media;
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  if (![0,90,180,270].includes(angle)) throw new Error('Unsupported PDF rotation');
  const width = angle % 180 ? box.height : box.width;
  const height = angle % 180 ? box.width : box.height;
  const u = field.x * width, v = (field.y + field.h) * height;
  const anchor = angle === 0 ? [box.x+u,box.y+box.height-v] : angle === 90 ? [box.x+v,box.y+u]
    : angle === 180 ? [box.x+box.width-u,box.y+v] : [box.x+box.width-v,box.y+box.height-u];
  const radians = angle * Math.PI / 180;
  const dx = Math.round(Math.cos(radians)), dy = Math.round(Math.sin(radians));
  return { width: field.w * width, height: field.h * height, angle,
    point: (x=0,y=0) => ({ x: anchor[0]+x*dx-y*dy, y: anchor[1]+x*dy+y*dx }) };
}
