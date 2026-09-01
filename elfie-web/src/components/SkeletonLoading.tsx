import { memo } from 'react';

interface ShimmerProps {
  width?: number | string;
  height?: number | string;
  style?: React.CSSProperties;
}

const ShimmerPlaceholder = memo(({ width = '100%', height = 200, style }: ShimmerProps) => {
  return (
    <div
      style={{
        width,
        height,
        backgroundColor: '#2c2c36',
        borderRadius: 12,
        overflow: 'hidden',
        position: 'relative',
        flexShrink: 0,
        ...style,
      }}
    >
      <div
        className="shimmer-animation"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '80%',
          height: '100%',
          background: 'linear-gradient(90deg, transparent, #3c3c47, transparent)',
        }}
      />
    </div>
  );
});

export default ShimmerPlaceholder;
