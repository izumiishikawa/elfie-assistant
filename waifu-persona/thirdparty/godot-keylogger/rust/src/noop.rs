// under no-op implementation, match the base Godot key input
// depending on the OS, more than likely it'll only capture input when the window has focus

use godot::prelude::*;
use godot::global::Key as GKey;
use godot::classes::InputEvent;
use godot::classes::InputEventKey;
use std::collections::HashMap;


#[derive(GodotClass)]
#[class(base=Node)]
pub struct Keylogger {
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
        
        Self {
            keystate,
            prev_keystate,
            hold_keystate,
            base
        }
    }

    fn input(&mut self, event: Gd<InputEvent>) {
      if let Ok(keyevent) = event.try_cast::<InputEventKey>() {
        let keycode = keyevent.get_keycode();

        if keyevent.is_pressed() {
          self.keystate.insert(keycode, true);
          self.hold_keystate.insert(keycode, true);
        }
        if keyevent.is_released() {
          self.keystate.insert(keycode, false);
        }
      }
    }

    fn process(&mut self, _delta: f64) {
      for (keycode, v) in self.hold_keystate.iter_mut() {
        let pressed = match self.keystate.get(keycode) {
            Some(res) => *res,
            _ => false
        };
        let prev_state = match self.prev_keystate.get(keycode) {
            Some(res) => *res,
            _ => false
        };

        *v = pressed && prev_state;
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