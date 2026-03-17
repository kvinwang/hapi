// Generate simple SVG-based PNG icons for the extension
// Using a canvas-like approach with SVG → PNG conversion isn't available in Bun,
// so we'll create placeholder PNGs using a minimal PNG generator

function createMinimalPNG(size: number): Buffer {
    // Create a simple colored square PNG
    // RGBA data: cyan-ish color (#89b4fa)
    const r = 0x89, g = 0xb4, b = 0xfa, a = 0xff

    const width = size, height = size

    // Raw RGBA pixel data
    const rawData: number[] = []
    for (let y = 0; y < height; y++) {
        rawData.push(0) // Filter byte: None
        for (let x = 0; x < width; x++) {
            // Simple circle check
            const cx = width / 2, cy = height / 2, radius = width * 0.4
            const dx = x - cx, dy = y - cy
            if (dx * dx + dy * dy <= radius * radius) {
                rawData.push(r, g, b, a)
            } else {
                rawData.push(0, 0, 0, 0) // Transparent
            }
        }
    }

    // Deflate the data
    const deflated = Bun.deflateSync(new Uint8Array(rawData))

    // Build PNG
    const chunks: Buffer[] = []

    // Signature
    chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

    // IHDR
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr.writeUInt8(8, 8)   // bit depth
    ihdr.writeUInt8(6, 9)   // color type: RGBA
    ihdr.writeUInt8(0, 10)  // compression
    ihdr.writeUInt8(0, 11)  // filter
    ihdr.writeUInt8(0, 12)  // interlace
    chunks.push(makeChunk('IHDR', ihdr))

    // IDAT
    chunks.push(makeChunk('IDAT', Buffer.from(deflated)))

    // IEND
    chunks.push(makeChunk('IEND', Buffer.alloc(0)))

    return Buffer.concat(chunks)
}

function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBytes = Buffer.from(type, 'ascii')
    const combined = Buffer.concat([typeBytes, data])
    const crc = crc32(combined)
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc >>> 0, 0)
    return Buffer.concat([len, combined, crcBuf])
}

function crc32(buf: Buffer): number {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
        c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff]
    }
    return c ^ 0xffffffff
}

const crcTable: number[] = []
for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    crcTable[n] = c
}

for (const size of [16, 48, 128]) {
    const png = createMinimalPNG(size)
    await Bun.write(`icons/icon${size}.png`, png)
    console.log(`Created icon${size}.png (${png.length} bytes)`)
}
