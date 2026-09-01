// under Linux/BSD, use libinput to track global input state

use evdev::EvdevEnum;
use godot::prelude::*;

use input::event::keyboard::{KeyboardEventTrait, KeyState};
use input::{Libinput, LibinputInterface};
use libc::{O_RDONLY, O_RDWR, O_WRONLY};
use std::fs::{File, OpenOptions};
use std::os::unix::{fs::OpenOptionsExt, io::OwnedFd};
use std::path::Path;
use std::collections::HashMap;

use godot::global::Key as GKey;

use evdev;
use evdev::Key as EKey;

struct Interface;

impl LibinputInterface for Interface {
    fn open_restricted(&mut self, path: &Path, flags: i32) -> Result<OwnedFd, i32> {
        OpenOptions::new()
            .custom_flags(flags)
            .read((flags & O_RDONLY != 0) | (flags & O_RDWR != 0))
            .write((flags & O_WRONLY != 0) | (flags & O_RDWR != 0))
            .open(path)
            .map(|file| file.into())
            .map_err(|err| err.raw_os_error().unwrap())
    }
    fn close_restricted(&mut self, fd: OwnedFd) {
        drop(File::from(fd));
    }
}

// annoying gross function that maps evdev key input to godot's input mapping
// don't bother with trying to turn this into a static map or anything,
// rust doesn't support static maps out of the box, and alternatives like phf
// require too much work for something that'll just codegen/unwrap to a match
// statement anyway.  This is the optimal way to do this.
fn evdev_to_godot(keycode: evdev::Key) -> Option<GKey> {
    match keycode {
        EKey::KEY_0 => Some(GKey::KEY_0),
        EKey::KEY_1 => Some(GKey::KEY_1),
        EKey::KEY_2 => Some(GKey::KEY_2),
        EKey::KEY_3 => Some(GKey::KEY_3),
        EKey::KEY_4 => Some(GKey::KEY_4),
        EKey::KEY_5 => Some(GKey::KEY_5),
        EKey::KEY_6 => Some(GKey::KEY_6),
        EKey::KEY_7 => Some(GKey::KEY_7),
        EKey::KEY_8 => Some(GKey::KEY_8),
        EKey::KEY_9 => Some(GKey::KEY_9),
        EKey::KEY_A => Some(GKey::A),
        EKey::KEY_B => Some(GKey::B),
        EKey::KEY_C => Some(GKey::C),
        EKey::KEY_D => Some(GKey::D),
        EKey::KEY_E => Some(GKey::E),
        EKey::KEY_F => Some(GKey::F),
        EKey::KEY_G => Some(GKey::G),
        EKey::KEY_H => Some(GKey::H),
        EKey::KEY_I => Some(GKey::I),
        EKey::KEY_J => Some(GKey::J),
        EKey::KEY_K => Some(GKey::K),
        EKey::KEY_L => Some(GKey::L),
        EKey::KEY_M => Some(GKey::M),
        EKey::KEY_N => Some(GKey::N),
        EKey::KEY_O => Some(GKey::O),
        EKey::KEY_P => Some(GKey::P),
        EKey::KEY_Q => Some(GKey::Q),
        EKey::KEY_R => Some(GKey::R),
        EKey::KEY_S => Some(GKey::S),
        EKey::KEY_T => Some(GKey::T),
        EKey::KEY_U => Some(GKey::U),
        EKey::KEY_V => Some(GKey::V),
        EKey::KEY_W => Some(GKey::W),
        EKey::KEY_X => Some(GKey::X),
        EKey::KEY_Y => Some(GKey::Y),
        EKey::KEY_Z => Some(GKey::Z),
        EKey::KEY_BACKSLASH => Some(GKey::BACKSLASH),
        EKey::KEY_COMMA => Some(GKey::COMMA),
        EKey::KEY_SEMICOLON => Some(GKey::SEMICOLON),
        EKey::KEY_APOSTROPHE => Some(GKey::APOSTROPHE),
        EKey::KEY_GRAVE => Some(GKey::ASCIITILDE),
        EKey::KEY_QUESTION => Some(GKey::QUESTION),
        EKey::KEY_DOLLAR => Some(GKey::DOLLAR),
        EKey::KEY_LEFTBRACE => Some(GKey::BRACELEFT),
        EKey::KEY_RIGHTBRACE => Some(GKey::BRACERIGHT),
        EKey::KEY_KPLEFTPAREN => Some(GKey::PARENLEFT),
        EKey::KEY_KPRIGHTPAREN => Some(GKey::PARENRIGHT),
        EKey::KEY_SLASH => Some(GKey::SLASH),
        EKey::KEY_EQUAL => Some(GKey::EQUAL),
        // function keys
        EKey::KEY_F1 => Some(GKey::F1),
        EKey::KEY_F2 => Some(GKey::F2),
        EKey::KEY_F3 => Some(GKey::F3),
        EKey::KEY_F4 => Some(GKey::F4),
        EKey::KEY_F5 => Some(GKey::F5),
        EKey::KEY_F6 => Some(GKey::F6),
        EKey::KEY_F7 => Some(GKey::F7),
        EKey::KEY_F8 => Some(GKey::F8),
        EKey::KEY_F9 => Some(GKey::F9),
        EKey::KEY_F10 => Some(GKey::F10),
        EKey::KEY_F11 => Some(GKey::F11),
        EKey::KEY_F12 => Some(GKey::F12),
        // control buttons
        EKey::KEY_ESC => Some(GKey::ESCAPE),
        EKey::KEY_TAB => Some(GKey::TAB),
        EKey::KEY_SPACE => Some(GKey::SPACE),
        EKey::KEY_BACKSPACE => Some(GKey::BACKSPACE),
        EKey::KEY_LEFTCTRL => Some(GKey::CTRL),
        EKey::KEY_RIGHTCTRL => Some(GKey::CTRL),
        EKey::KEY_LEFTALT => Some(GKey::ALT),
        EKey::KEY_RIGHTALT => Some(GKey::ALT),
        EKey::KEY_LEFTSHIFT => Some(GKey::SHIFT),
        EKey::KEY_RIGHTSHIFT => Some(GKey::SHIFT),
        EKey::KEY_ENTER => Some(GKey::ENTER),
        EKey::KEY_LEFT => Some(GKey::LEFT),
        EKey::KEY_UP => Some(GKey::UP),
        EKey::KEY_RIGHT => Some(GKey::RIGHT),
        EKey::KEY_DOWN => Some(GKey::DOWN),
        EKey::KEY_PAGEDOWN => Some(GKey::PAGEDOWN),
        EKey::KEY_PAGEUP => Some(GKey::PAGEUP),
        EKey::KEY_INSERT => Some(GKey::INSERT),
        EKey::KEY_HOME => Some(GKey::HOME),
        EKey::KEY_END => Some(GKey::END),
        EKey::KEY_CAPSLOCK => Some(GKey::CAPSLOCK),
        EKey::KEY_NUMLOCK => Some(GKey::NUMLOCK),
        EKey::KEY_SCROLLLOCK => Some(GKey::SCROLLLOCK),
        // media buttons
        EKey::KEY_PLAYPAUSE => Some(GKey::MEDIAPLAY),
        EKey::KEY_RECORD => Some(GKey::MEDIARECORD),
        EKey::KEY_STOP => Some(GKey::MEDIASTOP),
        EKey::KEY_NEXT => Some(GKey::MEDIANEXT),
        EKey::KEY_NEXTSONG => Some(GKey::MEDIANEXT),
        EKey::KEY_PREVIOUS => Some(GKey::MEDIAPREVIOUS),
        EKey::KEY_PREVIOUSSONG => Some(GKey::MEDIAPREVIOUS),
        EKey::KEY_VOLUMEUP => Some(GKey::VOLUMEUP),
        EKey::KEY_VOLUMEDOWN => Some(GKey::VOLUMEDOWN),
        // keypad
        EKey::KEY_KP0 => Some(GKey::KP_0),
        EKey::KEY_KP1 => Some(GKey::KP_1),
        EKey::KEY_KP2 => Some(GKey::KP_2),
        EKey::KEY_KP3 => Some(GKey::KP_3),
        EKey::KEY_KP4 => Some(GKey::KP_4),
        EKey::KEY_KP5 => Some(GKey::KP_5),
        EKey::KEY_KP6 => Some(GKey::KP_6),
        EKey::KEY_KP7 => Some(GKey::KP_7),
        EKey::KEY_KP8 => Some(GKey::KP_8),
        EKey::KEY_KP9 => Some(GKey::KP_9),
        EKey::KEY_KPASTERISK => Some(GKey::KP_MULTIPLY),
        EKey::KEY_KPSLASH => Some(GKey::KP_DIVIDE),
        EKey::KEY_KPPLUS => Some(GKey::KP_ADD),
        EKey::KEY_KPDOT => Some(GKey::KP_PERIOD),
        EKey::KEY_KPMINUS => Some(GKey::KP_SUBTRACT),
        EKey::KEY_KPENTER => Some(GKey::ENTER),

        // TODO some buttons are missing from evdev, instead expecting modifiers to map them
        _ => None
    }
}


#[derive(GodotClass)]
#[class(base=Node)]
pub struct Keylogger {
    input: Libinput,
    keystate: HashMap<godot::global::Key, bool>,
    prev_keystate: HashMap<godot::global::Key, bool>,
    hold_keystate: HashMap<godot::global::Key, bool>,
    base: Base<Node>,
}

#[godot_api]
impl INode for Keylogger {
    fn init(base: Base<Node>) -> Self {
        let keystate = HashMap::new();
        let prev_keystate = HashMap::new();
        let hold_keystate = HashMap::new();

        let mut input = Libinput::new_with_udev(Interface);
        input.udev_assign_seat("seat0").unwrap();
            
        Self {
            input,
            keystate,
            prev_keystate,
            hold_keystate,
            base
        }
    }

    fn process(&mut self, _delta: f64) {
        // receive event from libinput, polling once per process frame
        // we only care about keyboard messages for keylogger
        self.input.dispatch().unwrap();

        self.prev_keystate = self.keystate.clone();
        self.hold_keystate.clear();

        for event in &mut self.input {
            match event {
                input::Event::Keyboard(event) => {
                    let keycode = EKey::from_index(event.key() as usize);
                    if let Some(godotkey) = evdev_to_godot(keycode) {
                        let pressed = match event.key_state() {
                            KeyState::Pressed => true,
                            KeyState::Released => false
                        };

                        let prev_state = match self.prev_keystate.get(&godotkey) {
                            Some(res) => *res,
                            _ => false
                        };

                        self.keystate.insert(godotkey, pressed);
                        self.hold_keystate.insert(godotkey, pressed && prev_state);
                    }
                }
                _ => {}
            }
        }
    }
}

#[godot_api]
impl Keylogger {

    #[func]
    fn is_key_pressed(&mut self, keycode: GKey) -> bool {
        // map godot keycode to evdev keycode
        match self.keystate.get(&keycode) {
            Some(res) => *res,
            _ => false
        }
    }

    #[func]
    fn is_key_released(&mut self, keycode: GKey) -> bool {
        !self.is_key_pressed(keycode)
    }

    #[func]
    fn is_key_just_pressed(&mut self, keycode: GKey) -> bool {
        // map godot keycode to evdev keycode
        match self.hold_keystate.get(&keycode) {
            Some(false) => self.is_key_pressed(keycode),
            _ => false
        }
    }
}