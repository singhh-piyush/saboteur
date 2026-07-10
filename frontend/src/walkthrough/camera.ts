
export interface CameraTransform {
  scale: number;
  x: number;
  y: number;
}

export const CAMERA_IDENTITY: CameraTransform = { scale: 1, x: 0, y: 0 };

const PAD = 1.35;
const MAX_SCALE = 1.35;

/**
 * Camera push-in toward a target rect. `rect` is measured in the current
 * (possibly transformed) viewport, so it is first mapped back to base space.
 */
export function computeCamera(
  rect: { left: number; top: number; width: number; height: number },
  current: CameraTransform,
  vw: number,
  vh: number,
): CameraTransform {
  const bw = rect.width / current.scale;
  const bh = rect.height / current.scale;
  const bx = (rect.left - current.x) / current.scale;
  const by = (rect.top - current.y) / current.scale;

  const scale = Math.min(MAX_SCALE, Math.max(1, Math.min(vw / (bw * PAD), vh / (bh * PAD))));
  if (scale <= 1.02) return CAMERA_IDENTITY;

  let x = vw / 2 - scale * (bx + bw / 2);
  let y = vh / 2 - scale * (by + bh / 2);
  x = Math.min(0, Math.max(vw - scale * vw, x));
  y = Math.min(0, Math.max(vh - scale * vh, y));
  return { scale, x, y };
}
