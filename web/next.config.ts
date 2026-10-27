import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // Baileys loads a WebAssembly bridge at runtime; keep it out of the bundle.
  serverExternalPackages: ["baileys", "whatsapp-rust-bridge", "pino", "libsignal", "mammoth", "unpdf"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
