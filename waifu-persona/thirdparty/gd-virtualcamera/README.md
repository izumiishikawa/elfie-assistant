# gd-virtualcamera

V4L2 Loopback bindings for Godot.

Useful for enabling your application to output to a loopback device, for use as a Virtual Webcam or to simply forward image data between applications in Linux.

## Adding to your Project

gd-virtualcamera is a C++ based GDExtension.  Compile it with scons or grab an artifact from the github builds

Requires
- v4l2-loopback dkms module and system libraries
- Godot 4.4+

## Usage

Adds a new `VirtualCamera` Node type that you can add to any scene.  Connect a reference of a SubViewport to it and the path to a V4L2 Loopback device.

Make sure your loopback accepts 32-bit RGBA data and that your SubViewport's dimensions match the expected resolution.

You can do this with

```
v4l2loopback-ctl add 1
v4l2loopback-ctl set-caps /dev/video0 'AR24:1280x720@60/1' 
```


https://github.com/user-attachments/assets/e8d83431-0099-427e-b414-b947e7ff822b

