declare module 'prism-media' {
  import { Transform } from 'node:stream';
  const prism: {
    opus: {
      OggDemuxer: new() => Transform;
    };
  };
  export default prism;
}
