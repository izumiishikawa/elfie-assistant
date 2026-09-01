import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { DimensionValue, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

type ShimmerPlaceholderProps = {
  style?: StyleProp<ViewStyle>;
  height?: DimensionValue;
  width?: DimensionValue;
};

const ShimmerPlaceholder: React.FC<ShimmerPlaceholderProps> = ({
  style,
  height = 200,
  width = '100%',
}) => {
  const shimmerTranslateX = useSharedValue(-500);

  useEffect(() => {
    shimmerTranslateX.value = withRepeat(withTiming(500, { duration: 1500 }), -1, true);
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shimmerTranslateX.value }],
  }));

  return (
    <View style={[styles.container, { height, width }, style]}>
      <AnimatedLinearGradient
        colors={['transparent', '#3c3c47', 'transparent']}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={[styles.shimmer, animatedStyle]}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#2c2c36',
    overflow: 'hidden',
    borderRadius: 12,
  },
  shimmer: {
    width: '80%',
    height: '100%',
  },
});

export default ShimmerPlaceholder;
