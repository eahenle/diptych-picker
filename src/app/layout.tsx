import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dipycker",
  description: "An iterative two-image preference game.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
