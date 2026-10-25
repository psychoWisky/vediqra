import React from 'react';
import { motion } from 'framer-motion';
import * as Icons from 'lucide-react';
import { Share2 } from 'lucide-react';

interface CategoryCardProps {
  name: string;
  icon: string;
  icon_type?: 'emoji' | 'lucide' | 'image';
  image_url?: string;
  color: string;
  hover_effect?: string;
  count?: number;
  onClick?: () => void;
  onShare?: (e: React.MouseEvent) => void;
}

const CategoryCard: React.FC<CategoryCardProps> = ({
  name,
  icon,
  icon_type,
  image_url,
  color,
  hover_effect = 'scale',
  count,
  onClick,
  onShare,
}) => {
  // Auto-detect type if not explicitly set
  const resolvedType: 'emoji' | 'lucide' | 'image' = (() => {
    if (icon_type === 'image') return 'image';
    if (icon === 'image') return 'image'; // backend placeholder
    if (icon_type) return icon_type;
    if (icon?.startsWith('http') || icon?.startsWith('data:')) return 'image';
    if (icon && icon.length <= 4 && /\p{Emoji}/u.test(icon)) return 'emoji';
    return 'lucide';
  })();

  const IconComponent = resolvedType === 'lucide'
    ? ((Icons as any)[icon] || Icons.Gift)
    : null;

  // image_url prop takes priority; fall back to icon if it's a real URL
  const iconSrc = resolvedType === 'image'
    ? (image_url || (icon !== 'image' ? icon : null))
    : null;

  const getHoverAnimation = () => {
    switch (hover_effect) {
      case 'rotate': return { rotate: 3, scale: 1.02 };
      case 'bounce': return { y: -8, scale: 1.02 };
      case 'pulse': return { scale: [1, 1.03, 1], transition: { duration: 0.5 } };
      default: return { y: -5, scale: 1.02 };
    }
  };

  const getIconAnimation = () => {
    switch (hover_effect) {
      case 'rotate': return { rotate: 15 };
      case 'bounce': return { y: -3 };
      default: return { scale: 1.1 };
    }
  };

  return (
    <motion.div
      whileHover={getHoverAnimation()}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className="relative cursor-pointer overflow-hidden rounded-sm border border-brand-line bg-brand-elevated p-5 text-center transition-colors duration-300 group hover:border-brand-accent/60"
    >

      {/* Icon Container */}
      <motion.div
        whileHover={getIconAnimation()}
        transition={{ type: 'spring', stiffness: 300 }}
        className="relative z-10"
      >
        {resolvedType === 'image' && iconSrc ? (
          <img
            src={iconSrc}
            alt={name}
            className="w-14 h-14 mx-auto mb-4 object-contain group-hover:scale-110 transition-transform duration-300"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        ) : IconComponent ? (
          <IconComponent
            className="mx-auto mb-4 h-10 w-10 text-brand-accent transition-colors duration-300"
            strokeWidth={1.25}
          />
        ) : (
          <span className="text-6xl mb-4 block group-hover:scale-110 transition-transform duration-300">{icon}</span>
        )}
      </motion.div>

      <h3 className="relative z-10 mb-1 font-display text-lg font-semibold text-brand-ink transition-colors duration-300">
        {name}
      </h3>

      {count !== undefined && (
        <p className="text-sm text-brand-muted relative z-10 transition-colors duration-300">
          {count} {count === 1 ? 'gift' : 'gifts'}
        </p>
      )}

      {/* Share button — appears on hover, stops card click propagation */}
      {onShare && (
        <button
          onClick={onShare}
          className="absolute top-2 right-2 z-20 w-7 h-7 rounded-full bg-brand-surface/80 text-brand-ink backdrop-blur-sm shadow flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 hover:bg-brand-surface hover:scale-110"
          title={`Share ${name}`}
        >
          <Share2 className="h-3.5 w-3.5 text-brand-ink" />
        </button>
      )}
    </motion.div>
  );
};

export default CategoryCard;
