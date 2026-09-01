import { forwardRef, type ElementRef } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type AnimatedStyle,
  type EntryOrExitLayoutType,
} from "react-native-reanimated";
import { PRESS_SCALE, springPress } from "../utils/motion";

const AnimatedPressableBase = Animated.createAnimatedComponent(Pressable);

interface AnimatedPressableProps extends Omit<PressableProps, "style"> {
  scaleTo?: number;
  style?: StyleProp<AnimatedStyle<ViewStyle>>;
  entering?: EntryOrExitLayoutType;
  exiting?: EntryOrExitLayoutType;
}

// Equivalente ao whileTap do framer-motion: encolhe com spring ao tocar
// e volta ao soltar. Use no lugar de TouchableOpacity para qualquer
// elemento que precise de feedback tátil "vivo".
const AnimatedPressable = forwardRef<
  ElementRef<typeof AnimatedPressableBase>,
  AnimatedPressableProps
>(({ scaleTo = PRESS_SCALE, style, onPressIn, onPressOut, ...props }, ref) => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressableBase
      ref={ref}
      style={[style, animatedStyle]}
      onPressIn={(e) => {
        scale.value = withSpring(scaleTo, springPress);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, springPress);
        onPressOut?.(e);
      }}
      {...props}
    />
  );
});

export default AnimatedPressable;
