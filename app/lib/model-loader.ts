import {GLTFLoader, type GLTF} from 'three/addons/loaders/GLTFLoader.js';

/** Decode deployment gzip independently of the host's HTTP compression. */
export class ModelLoader extends GLTFLoader {
  override parse(
    data: ArrayBuffer | string,
    path: string,
    onLoad: (gltf: GLTF) => void,
    onError?: (error: ErrorEvent) => void,
  ): void {
    const bytes = typeof data === 'string' ? null : new Uint8Array(data);
    if (bytes?.[0] !== 0x1f || bytes[1] !== 0x8b) {
      super.parse(data, path, onLoad, onError);
      return;
    }
    void new Response(
      new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer().then((decoded) => {
      super.parse(decoded, path, onLoad, onError);
    }).catch((error: unknown) => onError?.(error as ErrorEvent));
  }
}
