/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ['selector', '[data-nf="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        surface2: "var(--surface2)",
        border: "var(--border)",
        text: "var(--text)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        faint2: "var(--faint2)",
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent2)",
        },
        danger: "var(--danger)",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Helvetica Neue"',
          "Helvetica",
          '"Segoe UI"',
          "sans-serif",
        ],
      },
      borderRadius: {
        pill: "99px",
        hero: "30px",
        modal: "28px",
        card: "22px",
        card2: "24px",
        lead: "18px",
        tile: "16px",
        input: "14px",
        nav: "11px",
        tab: "9px",
        check: "6px",
      },
      boxShadow: {
        card: "var(--shadow)",
        accent: "0 10px 24px -10px var(--accent)",
        modal: "0 40px 90px -40px rgba(0,0,0,.4)",
        tabActive: "0 2px 8px -3px rgba(0,0,0,.25)",
      },
      transitionTimingFunction: {
        nf: "cubic-bezier(.2,.7,.2,1)",
        nfPop: "cubic-bezier(.2,.8,.2,1)",
      },
      keyframes: {
        nfFadeUp: {
          from: { opacity: "0", transform: "translateY(14px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        nfFade: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        nfPop: {
          from: { opacity: "0", transform: "translateY(18px) scale(.97)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        nfSlide: {
          from: { opacity: "0", transform: "translateX(28px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        nfDraw: {
          from: { strokeDashoffset: "1200" },
          to: { strokeDashoffset: "0" },
        },
        nfPulse: {
          "0%": { transform: "scale(1)", opacity: "0.55" },
          "100%": { transform: "scale(1.9)", opacity: "0" },
        },
        nfTap: {
          "0%": { transform: "scale(1)" },
          "35%": { transform: "scale(0.92)" },
          "100%": { transform: "scale(1)" },
        },
        nfFlashRing: {
          "0%": { boxShadow: "0 0 0 0 rgba(242,86,11,.55)" },
          "70%": { boxShadow: "0 0 0 10px rgba(242,86,11,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(242,86,11,0)" },
        },
      },
      animation: {
        nfFadeUp: "nfFadeUp 550ms cubic-bezier(.2,.7,.2,1) both",
        nfFade: "nfFade 380ms cubic-bezier(.2,.7,.2,1) both",
        nfPop: "nfPop 420ms cubic-bezier(.2,.8,.2,1) both",
        nfSlide: "nfSlide 600ms cubic-bezier(.2,.7,.2,1) both",
        nfDraw: "nfDraw 1500ms cubic-bezier(.2,.7,.2,1) both",
        nfPulse: "nfPulse 1900ms cubic-bezier(.2,.7,.2,1) infinite",
        nfTap: "nfTap 280ms cubic-bezier(.2,.8,.2,1) both",
        nfFlashRing: "nfFlashRing 700ms cubic-bezier(.2,.7,.2,1) both",
      },
    },
  },
  plugins: [],
};
