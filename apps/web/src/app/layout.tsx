import type { Metadata } from "next";
import { Inter, Merriweather, Noto_Sans, Playfair_Display, Source_Sans_3 } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

// Every selectable brand font is self-hosted by next/font; a company picks by key (see lib/fonts.ts).
const merriweather = Merriweather({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-merriweather", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], variable: "--font-playfair", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const sourceSans = Source_Sans_3({ subsets: ["latin"], variable: "--font-source-sans", display: "swap" });
const notoSans = Noto_Sans({ subsets: ["latin"], variable: "--font-noto-sans", display: "swap" });

export const metadata: Metadata = { title: { default: "Email Tracker", template: "%s · Email Tracker" }, description: "Outlook reply tracking and AI thread summaries" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${merriweather.variable} ${playfair.variable} ${inter.variable} ${sourceSans.variable} ${notoSans.variable} font-heading-merriweather font-body-source-sans`}>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
