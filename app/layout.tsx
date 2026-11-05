import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Signhify GTM Autopilot OS",
  description:
    "Paste a product URL. Get a cited ICP draft, a content calendar and an approval-gated publishing queue.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#0b0e13",
          color: "#e8ecf1",
        }}
      >
        {children}
      </body>
    </html>
  );
}
