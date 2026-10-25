import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Play, Pause, Volume2, VolumeX, ChevronLeft, ChevronRight } from 'lucide-react';
import { HeroContent } from '../types';

interface HeroSectionProps {
  heroes: HeroContent[];
  autoplay?: boolean;
  interval?: number;
}

/** Admin-entered CTA target: on-site paths use the router (no full page reload), anything else is a normal link. */
const CtaLink: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }> = ({ href, children, ...rest }) =>
  href.startsWith('/') && !href.startsWith('//')
    ? <Link to={href} {...rest}>{children}</Link>
    : <a href={href} {...rest}>{children}</a>;

const HeroSection: React.FC<HeroSectionProps> = ({
  heroes,
  autoplay = true,
  interval = 5000
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const reduceMotion = useReducedMotion();
  const [isPlaying, setIsPlaying] = useState(autoplay);                       // video play/pause
  const [rotating, setRotating] = useState(autoplay);                        // automatic slide rotation (user can pause it)
  const autoRotate = rotating && !reduceMotion && heroes.length > 1;          // never rotate on their own for people who asked for less motion
  const [isMuted, setIsMuted] = useState(true);
  const [isVideoLoaded, setIsVideoLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout>();

  const currentHero = heroes[currentIndex] || heroes[0];

  useEffect(() => {
    if (heroes.length === 0) return;

    if (autoRotate) {
      timeoutRef.current = setTimeout(() => {
        nextSlide();
      }, interval);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [currentIndex, autoRotate, heroes.length]);

  useEffect(() => {
    if (videoRef.current) {
      if (currentHero?.media_type === 'video') {
        videoRef.current.load();
        setIsVideoLoaded(false);
      }
    }
  }, [currentIndex]);

  const nextSlide = () => {
    setCurrentIndex((prev) => (prev + 1) % heroes.length);
  };

  const prevSlide = () => {
    setCurrentIndex((prev) => (prev - 1 + heroes.length) % heroes.length);
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play();
        setIsPlaying(true);
      } else {
        videoRef.current.pause();
        setIsPlaying(false);
      }
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(!isMuted);
    }
  };

  // Get alignment classes based on content_alignment
  const getAlignmentClasses = () => {
    const alignment = currentHero.content_alignment || 'center';
    
    switch(alignment) {
      case 'left':
        return {
          container: 'justify-start',
          text: 'text-left',
          content: 'max-w-3xl'
        };
      case 'right':
        return {
          container: 'justify-end',
          text: 'text-right',
          content: 'max-w-3xl'
        };
      case 'center':
      default:
        return {
          container: 'justify-center',
          text: 'text-center',
          content: 'max-w-3xl mx-auto'
        };
    }
  };

  const alignment = getAlignmentClasses();

  if (heroes.length === 0) {
    return null;
  }

  return (
    <div aria-roledescription={heroes.length > 1 ? 'carousel' : undefined}
      aria-label={heroes.length > 1 ? 'Featured banners' : undefined}
      className="relative h-[72vh] max-h-[760px] min-h-[460px] overflow-hidden bg-brand-panel md:h-[80vh] md:min-h-[560px]">
      {/* Background Media */}
      <AnimatePresence mode="wait">
        <motion.div
          key={currentIndex}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1 }}
          className="absolute inset-0"
        >
          {currentHero.media_type === 'video' ? (
            <>
              <video
                ref={videoRef}
                src={currentHero.media_url}
                poster={currentHero.video_poster_url}
                autoPlay={currentHero.autoplay}
                loop={currentHero.loop}
                muted={currentHero.muted}
                playsInline
                onLoadedData={() => setIsVideoLoaded(true)}
                className="w-full h-full object-cover"
              />
              {!isVideoLoaded && (
                <div className="absolute inset-0 bg-gray-900 animate-pulse flex items-center justify-center">
                  <div className="text-white">Loading video...</div>
                </div>
              )}
            </>
          ) : (
            <img
              src={currentHero.media_url}
              alt=""
              className="w-full h-full object-cover"
            />
          )}
          
          {/* Dynamic Overlay - changes based on content alignment */}
          <div 
            className={`absolute inset-0 ${
              alignment.text === 'text-left' 
                ? 'bg-gradient-to-r from-black/80 via-black/60 to-transparent' 
                : alignment.text === 'text-right'
                ? 'bg-gradient-to-l from-black/80 via-black/60 to-transparent'
                : 'bg-black/50'
            }`} 
          />
        </motion.div>
      </AnimatePresence>

      {/* Content - Dynamically positioned based on alignment */}
      <div className={`relative h-full flex items-center z-10 ${alignment.container}`}>
        <div className="container mx-auto px-4">
          <motion.div
            key={currentIndex}
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className={`${alignment.content} ${alignment.text} text-white`}
          >
            <h1 className="text-4xl sm:text-5xl md:text-7xl font-heading font-bold mb-4 md:mb-6 leading-tight">
              {currentHero.title}
            </h1>
            <p className="text-lg md:text-2xl text-gray-200 mb-8 leading-relaxed">
              {currentHero.subtitle}
            </p>
            {currentHero.cta_text && currentHero.cta_link && (
              <CtaLink
                href={currentHero.cta_link}
                className={`inline-flex items-center px-6 py-3 md:px-8 md:py-4 bg-brand-accent text-[#111111] rounded-xl hover:bg-brand-accent-ink transition-all duration-300 text-base md:text-lg font-semibold group ${
                  alignment.text === 'text-center' ? 'mx-auto' : ''
                }`}
              >
                {currentHero.cta_text}
                <ChevronRight className="ml-2 h-5 w-5 group-hover:translate-x-2 transition-transform" aria-hidden="true" />
              </CtaLink>
            )}
          </motion.div>
        </div>
      </div>

      {/* Video Controls (only for video) */}
      {currentHero.media_type === 'video' && (
        <div className="absolute bottom-8 right-8 z-20 flex gap-2">
          <button
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause video' : 'Play video'}
            className="p-3 bg-white/20 backdrop-blur-sm rounded-full hover:bg-white/40 transition-colors text-white"
          >
            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </button>
          <button
            onClick={toggleMute}
            aria-label={isMuted ? 'Unmute video' : 'Mute video'}
            className="p-3 bg-white/20 backdrop-blur-sm rounded-full hover:bg-white/40 transition-colors text-white"
          >
            {isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
        </div>
      )}

      {/* Navigation Arrows - Only show if more than one hero */}
      {heroes.length > 1 && (
        <>
          <button
            onClick={prevSlide}
            aria-label="Previous banner"
            className="absolute left-2 md:left-8 top-1/2 -translate-y-1/2 z-20 p-3 bg-white/20 backdrop-blur-sm rounded-full hover:bg-white/40 transition-colors text-white"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            onClick={nextSlide}
            aria-label="Next banner"
            className="absolute right-2 md:right-8 top-1/2 -translate-y-1/2 z-20 p-3 bg-white/20 backdrop-blur-sm rounded-full hover:bg-white/40 transition-colors text-white"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      {/* Pause / resume automatic rotation (not offered when rotation is off for reduced motion) */}
      {heroes.length > 1 && !reduceMotion && (
        <button
          type="button"
          onClick={() => setRotating((r) => !r)}
          aria-label={rotating ? 'Pause automatic slide rotation' : 'Resume automatic slide rotation'}
          className="absolute bottom-5 left-2 md:bottom-6 md:left-8 z-20 flex h-11 w-11 items-center justify-center bg-white/20 backdrop-blur-sm rounded-full hover:bg-white/40 transition-colors text-white"
        >
          {rotating ? <Pause className="h-5 w-5" aria-hidden="true" /> : <Play className="h-5 w-5" aria-hidden="true" />}
        </button>
      )}

      {/* Slide Indicators */}
      {heroes.length > 1 && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 flex gap-2">
          {heroes.map((_, index) => (
            <button
              key={index}
              onClick={() => setCurrentIndex(index)}
              aria-label={`Show banner ${index + 1} of ${heroes.length}`}
              aria-current={index === currentIndex}
              className={`h-2 rounded-full transition-all ${
                index === currentIndex
                  ? 'w-8 bg-brand-accent'
                  : 'w-2 bg-white/50 hover:bg-white/80'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default HeroSection;