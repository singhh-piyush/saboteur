
export interface CameraTransform {
  scale: number;
  x: number;
  y: number;
}

export const CAMERA_IDENTITY: CameraTransform = { scale: 1, x: 0, y: 0 };

const PAD = 1.35;
const MAX_SCALE = 1.35;

export interface SimpleRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Map a rect measured under `cam` back to untransformed base space. */
export function untransformRect(rect: SimpleRect, cam: CameraTransform): SimpleRect {
  return {
    left: (rect.left - cam.x) / cam.scale,
    top: (rect.top - cam.y) / cam.scale,
    width: rect.width / cam.scale,
    height: rect.height / cam.scale,
  };
}

/** Map a base-space rect to where it will render under `cam`. */
export function applyToRect(rect: SimpleRect, cam: CameraTransform): SimpleRect {
  return {
    left: cam.x + cam.scale * rect.left,
    top: cam.y + cam.scale * rect.top,
    width: cam.scale * rect.width,
    height: cam.scale * rect.height,
  };
}

/** Camera push-in toward a target rect given in base (untransformed) space. */
export function computeCamera(
  base: SimpleRect,
  vw: number,
  vh: number,
): CameraTransform {
  const scale = Math.min(
    MAX_SCALE,
    Math.max(1, Math.min(vw / (base.width * PAD), vh / (base.height * PAD))),
  );
  if (scale <= 1.02) return CAMERA_IDENTITY;

  let x = vw / 2 - scale * (base.left + base.width / 2);
  let y = vh / 2 - scale * (base.top + base.height / 2);
  x = Math.min(0, Math.max(vw - scale * vw, x));
  y = Math.min(0, Math.max(vh - scale * vh, y));
  return { scale, x, y };
}
