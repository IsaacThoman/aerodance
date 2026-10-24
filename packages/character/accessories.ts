import type { Object3D } from 'three';

/** Keep inactive accessory skins out of the per-frame matrix/inverse traversal. */
export function createAccessorySelector(model: Object3D, { detach = true } = {}) {
  const parts: { object: Object3D; parent: Object3D; visible: boolean }[] = [];
  model.traverse((object) => {
    if (object.name.startsWith('acc_') && object.parent) parts.push({ object, parent: object.parent, visible: object.visible });
  });
  return {
    select(name: string) {
      const prefix = `acc_${name.toLowerCase()}_`;
      for (const { object, parent } of parts) {
        object.visible = object.name.startsWith(prefix);
        if (object.visible) { if (object.parent !== parent) parent.add(object); }
        else if (detach) object.removeFromParent();
      }
    },
    restore() {
      for (const { object, parent, visible } of parts) {
        if (object.parent !== parent) parent.add(object);
        object.visible = visible;
      }
    },
  };
}
