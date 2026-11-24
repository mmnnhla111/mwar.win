import { SOCIAL_IMAGE_MAX_BYTES, SOCIAL_IMAGE_MAX_WIDTH, SOCIAL_IMAGE_WEBP_QUALITY } from '@mwar/shared';

/**
 * Resize + compress a picked photo 100 % on the client with <canvas>:
 * max width 720 px, WebP quality 0.72, and a strict 120 KB ceiling (quality, then size, step down).
 */
export async function compressImageToWebp(file: File, maxWidth = SOCIAL_IMAGE_MAX_WIDTH): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Please pick an image file');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read this image'));
      el.src = url;
    });
    let width = Math.min(maxWidth, img.naturalWidth || maxWidth);
    let quality = SOCIAL_IMAGE_WEBP_QUALITY;
    for (let attempt = 0; attempt < 8; attempt++) {
      const scale = width / (img.naturalWidth || width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round((img.naturalHeight || width) * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas is not available');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
      if (!blob || blob.type !== 'image/webp') throw new Error('This browser cannot create WebP images');
      if (blob.size <= SOCIAL_IMAGE_MAX_BYTES) return blob;
      if (quality > 0.5) quality -= 0.1;
      else width = Math.round(width * 0.8);
    }
    throw new Error('Image is too large even after compression');
  } finally {
    URL.revokeObjectURL(url);
  }
}
