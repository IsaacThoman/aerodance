`video-fixture.webm` contains two copies of the existing Google MediaPipe sample
image (`client/tests/fixtures/mediapipe-pose.jpg`). It is a 640×480, 10 fps,
0.8-second VP9 video used to verify real decoding and model inference. The source
and attribution are documented in `client/tests/fixtures/mediapipe-pose.md`.

Regenerate from the repository root:

```sh
ffmpeg -loop 1 -i client/tests/fixtures/mediapipe-pose.jpg \
  -filter_complex '[0:v]crop=600:667:200:0,scale=320:356,split=2[left][right];color=white:s=640x480:r=10[bg];[bg][left]overlay=0:40[mid];[mid][right]overlay=320:40[out]' \
  -map '[out]' -t 0.8 -r 10 -c:v libvpx-vp9 -pix_fmt yuv420p -an \
  tools/choreography/tests/video-fixture.webm
```

`solo-video-fixture.webm` crops the left copy to a centered solo dancer and adds
a 440 Hz Opus audio track. It verifies solo inference, audio decoding, mirroring,
and two-player export with the same source attribution:

```sh
ffmpeg -i tools/choreography/tests/video-fixture.webm \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -map 0:v -map 1:a -vf crop=320:480:0:0 -t 0.8 -r 10 \
  -c:v libvpx-vp9 -c:a libopus -pix_fmt yuv420p \
  tools/choreography/tests/solo-video-fixture.webm
```
