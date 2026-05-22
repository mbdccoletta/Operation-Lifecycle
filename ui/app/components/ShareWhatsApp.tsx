import React from "react";

interface ShareWhatsAppProps {
  problemName: string;
  status: string;
  category: string;
  displayId?: string;
}

// Native button so the visual matches the other row actions
// (Copy ID, Share link, Open Problem App). The Strato Button we
// used before brought its own theme that clashed with the dark
// canvas — too prominent and inconsistent with the neighbouring
// chip-style actions.
export const ShareWhatsApp = ({ problemName, status, category, displayId }: ShareWhatsAppProps) => {
  const handleShare = () => {
    const message = [
      `🚨 Problem: ${problemName}`,
      `Status: ${status}`,
      `Category: ${category}`,
      displayId ? `ID: ${displayId}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const encodedText = encodeURIComponent(message);
    window.open(`https://wa.me/?text=${encodedText}`, "_blank", "noopener,noreferrer");
  };

  return (
    <button type="button" className="neo-row-act" onClick={handleShare}>
      <span className="neo-row-act-icon" aria-hidden="true">▤</span>
      <span>WhatsApp</span>
    </button>
  );
};
