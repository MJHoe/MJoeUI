import { useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ImageOff } from 'lucide-react';
import clsx from 'clsx';
import { tiltOf } from '../lib/category';
import type { MediaKind } from '../types';

const SPRING = { type: 'spring', stiffness: 520, damping: 24 } as const;

/**
 * A die-cut sticker: white border, soft shadow, a small deterministic tilt.
 * Hover straightens and lifts it and curls the corner; `slap` springs it in
 * like it was just stuck onto the page.
 */
export function Sticker({
  id, media, alt = '', tilt = true, slap = false, selected, onClick, className, children, label, fit = 'cover',
}: {
  id: string;
  media: { url: string; kind: MediaKind } | null;
  alt?: string;
  tilt?: boolean;
  slap?: boolean;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
  children?: ReactNode;
  label?: string;
  fit?: 'cover' | 'contain';
}) {
  const deg = tilt ? tiltOf(id) : 0;
  const Comp = onClick ? motion.button : motion.div;
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      className={clsx('sticker', selected && 'is-selected', fit === 'contain' && 'sticker--contain', className)}
      aria-label={label}
      aria-pressed={onClick && selected !== undefined ? selected : undefined}
      onClick={onClick}
      initial={slap ? { scale: 1.4, rotate: deg + 12, opacity: 0, y: -16 } : false}
      animate={{ scale: 1, rotate: deg, opacity: 1, y: 0 }}
      whileHover={onClick ? { rotate: 0, y: -3, scale: 1.035 } : undefined}
      whileTap={onClick ? { scale: 0.96 } : undefined}
      transition={SPRING}
    >
      <span className="sticker__media">
        <Media media={media} alt={alt} />
      </span>
      {children}
    </Comp>
  );
}

export function Media({ media, alt, controls, autoPlay }: {
  media: { url: string; kind: MediaKind } | null;
  alt: string;
  controls?: boolean;
  autoPlay?: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  if (!media || broken === media.url) {
    return (
      <span className="media-missing">
        <ImageOff size={18} aria-hidden />
        {media && <span>文件不见了</span>}
      </span>
    );
  }
  if (media.kind === 'video') {
    return (
      <video
        ref={video}
        src={controls || autoPlay ? media.url : `${media.url}#t=0.1`}
        muted={!controls}
        loop
        playsInline
        controls={controls}
        autoPlay={autoPlay}
        preload="metadata"
        onMouseEnter={() => { if (!controls) void video.current?.play().catch(() => {}); }}
        onMouseLeave={() => { if (!controls && !autoPlay) video.current?.pause(); }}
        onError={() => setBroken(media.url)}
      />
    );
  }
  return (
    <img
      src={media.url}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setBroken(media.url)}
    />
  );
}
