import React from "react";
import logoImg from "../logo.jpg";

interface LogoProps {
  className?: string;
  variant?: "badge" | "text" | "light";
}

export function CieloLogo({ className = "w-11 h-11" }: LogoProps) {
  return (
    <img
      src={logoImg}
      alt="Cielo Logo"
      className={`object-cover rounded-lg select-none ${className}`}
      referrerPolicy="no-referrer"
    />
  );
}
