import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Live Listener",
  description: "Real-time room listener → LLM gate → local feed prototype",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
