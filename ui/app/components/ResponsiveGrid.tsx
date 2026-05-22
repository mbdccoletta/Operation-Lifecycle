import React from "react";
import { Flex } from "@dynatrace/strato-components/layouts";

interface ResponsiveGridProps {
  children: React.ReactNode;
}

export const ResponsiveGrid = ({ children }: ResponsiveGridProps) => {
  return (
    <Flex flexDirection="row" flexWrap="wrap" gap={16}>
      {children}
    </Flex>
  );
};
