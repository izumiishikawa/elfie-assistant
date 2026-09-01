import { useEffect, useState } from 'react';
import { Keyboard, KeyboardAvoidingViewProps, Platform } from 'react-native';

export function useKeyboardBehavior() {
  const defaultValue: KeyboardAvoidingViewProps['behavior'] =
    Platform.OS === 'ios' ? 'padding' : 'height';
  const [behaviour, setBehaviour] = useState<KeyboardAvoidingViewProps['behavior']>(defaultValue);
  useEffect(() => {
    const showListener = Keyboard.addListener('keyboardDidShow', () => {
      setBehaviour(defaultValue);
    });
    const hideListener = Keyboard.addListener('keyboardDidHide', () => {
      setBehaviour(undefined);
    });
    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);
  return behaviour;
}
