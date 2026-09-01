# Godot Keylogger

This is a stopgap solution for Godot to support Global input handling.  Useful for applications which should be able to read input while in the background.

Currently only supports Linux by means of listening to LibInput/evdev

## Proposal References

- https://github.com/godotengine/godot-proposals/issues/1919
- https://github.com/godotengine/godot-proposals/issues/11607

# Building the Extension

This extension is built using godot-rs
You can build it by using

```
cargo build
```

# Using the Extension

It's expected that you enable the Plugin for the extension, which adds a LibinputKeylogger autoload to your project under the name of "GlobalInput"

From there, you can poll GlobalInput with the same enums and similar functions as Input within the _process function and other places.  It updates its state once per process frame.

In this example, we can see our Node printing a different message based on if the `A key` is pressed while the window is in focus or not.
```
extends Node

func _process(delta):
    if Input.is_key_pressed(KEY_A):
        print("hello alice")
    elif GlobalInput.is_key_pressed(KEY_A):
        print("hello bob")
```