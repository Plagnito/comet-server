// Retire les métadonnées (EXIF, géolocalisation, modèle d'appareil…) des images
// en les ré-encodant via un canvas — les métadonnées ne survivent pas au ré-encodage.
const STRIP_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function stripImageMetadata(file) {
  if (!STRIP_TYPES.includes(file.type)) return Promise.resolve(file);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        c.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) return resolve(file);
          resolve(new File([blob], file.name, { type: blob.type, lastModified: Date.now() }));
        }, file.type, 0.92);
      } catch { URL.revokeObjectURL(url); resolve(file); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}
