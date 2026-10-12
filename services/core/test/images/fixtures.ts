/** Tiny image bytes for the image tests: real signatures and headers, no pixels worth decoding. */

/** A PNG header that says width × height. */
export function png(width = 1, height = 1): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
