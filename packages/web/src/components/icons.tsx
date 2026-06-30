/** Ícones de traço inline (stroke = currentColor). Tamanho via prop `size`. */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
  };
}

export const HeartIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 20s-7-4.6-9.2-9.1C1.4 8 2.8 4.8 6 4.8c2 0 3.2 1.3 4 2.4.8-1.1 2-2.4 4-2.4 3.2 0 4.6 3.2 3.2 6.1C19 15.4 12 20 12 20z" />
  </svg>
);

export const ShieldIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3z" />
  </svg>
);

export const EyeIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

export const BootIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7 3v9l-2 1c-1.2.6-2 1.8-2 3.2V19h18v-2c0-2-1.6-3.4-3.6-3.8L11 12V3H7z" />
  </svg>
);

export const FeatherIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M20 4C11 4 6 9 6 16l-2 4" />
    <path d="M16 8l-8 8M19 9h-5M14 14H9" />
  </svg>
);

export const StarIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3l2.6 5.5 6 .8-4.4 4.2 1.1 6L12 16.9 6.7 19.5l1.1-6L3.4 9.3l6-.8L12 3z" />
  </svg>
);

export const UploadIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
  </svg>
);

export const ScrollIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 4h11a2 2 0 012 2v12a2 2 0 01-2 2H8a2 2 0 01-2-2V4z" />
    <path d="M6 4a2 2 0 00-2 2v2h4M9 9h6M9 13h6" />
  </svg>
);

export const ArrowRightIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
