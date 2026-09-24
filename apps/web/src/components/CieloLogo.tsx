import React from "react";
import logoImg from "../logo.jpg";
import logoWordmarkImg from "../logo-wordmark.png";

interface LogoProps {
  className?: string;
  /**
   * "badge" (padrão): quadrado azul-escuro com "cielo" em branco — usado como
   * ícone, sobre qualquer fundo.
   * "wordmark": logo horizontal transparente, para fundo claro/branco — não
   * tem contorno próprio, então NÃO usar sobre fundo escuro ou colorido.
   */
  variant?: "badge" | "wordmark";
}

export function CieloLogo({ className = "w-11 h-11", variant = "badge" }: LogoProps) {
  if (variant === "wordmark") {
    return (
      <img
        src={logoWordmarkImg}
        alt="Cielo"
        className={`object-contain select-none ${className}`}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <img
      src={logoImg}
      alt="Cielo Logo"
      className={`object-cover rounded-lg select-none ${className}`}
      referrerPolicy="no-referrer"
    />
  );
}
