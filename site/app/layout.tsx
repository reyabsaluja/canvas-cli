import type { Metadata } from "next";
import { Geist_Pixel } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import { VERSION } from "@/lib/version";

// Display voice for titles and section headings, as on the portfolio.
const geistPixel = Geist_Pixel({
  variable: "--font-geist-pixel-src",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://reyabsaluja.github.io/canvas-cli/"),
  title: { default: "canvas-cli", template: "%s · canvas-cli" },
  description:
    "Canvas LMS in your terminal: courses, assignments, grades, and an assistant that reads your course material and shows its sources.",
  openGraph: { siteName: "canvas-cli docs", type: "website" },
};

// Runs before first paint so a dark-mode reader never sees a white flash.
// Same `theme` key and OS fallback as the portfolio.
const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className={`${geistPixel.variable} antialiased`}>
        <Sidebar version={VERSION} />
        <MobileNav version={VERSION} />
        <div className="lg:pl-[264px]">{children}</div>
      </body>
    </html>
  );
}
