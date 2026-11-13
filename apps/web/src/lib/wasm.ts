/**
 * Reads the exported function names of a WASM module (export section, id 7).
 * A NEAR contract method is a WASM export with the same name, so this tells the UI which Gate 2
 * methods (`settle_round`, `claim_reward`, …) the *deployed* code really has — no guessing.
 */

export function wasmFunctionExports(bytes: Uint8Array): Set<string> {
  const names = new Set<string>();
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("Not a WASM module");
  }
  let p = 8; // magic + version
  const dec = new TextDecoder();

  const leb = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (p >= bytes.length) throw new Error("Truncated WASM");
      const b = bytes[p++]!;
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new Error("Bad LEB128");
    }
  };

  while (p < bytes.length) {
    const id = bytes[p++]!;
    const size = leb();
    const end = p + size;
    if (end > bytes.length) throw new Error("Truncated WASM section");
    if (id === 7) {
      const count = leb();
      for (let i = 0; i < count; i++) {
        const len = leb();
        const name = dec.decode(bytes.subarray(p, p + len));
        p += len;
        const kind = bytes[p++];
        leb(); // index
        if (kind === 0x00) names.add(name);
      }
      return names;
    }
    p = end;
  }
  return names;
}
