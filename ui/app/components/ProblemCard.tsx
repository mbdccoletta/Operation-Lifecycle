import React from "react";
import { Surface, Flex } from "@dynatrace/strato-components/layouts";
import { Text, Heading } from "@dynatrace/strato-components/typography";
import { getCategoryColor, getCategoryLabel, formatRelativeTime, getStatusLabel } from "../utils/formatters";
import type { Problem } from "../hooks/useProblems";

interface ProblemCardProps {
  problem: Problem;
  onClick?: () => void;
}

export const ProblemCard = ({ problem, onClick }: ProblemCardProps) => {
  return (
    <Surface onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      <Flex flexDirection="column" gap={8} padding={16}>
        <Flex justifyContent="space-between" alignItems="center">
          <Heading level={6}>{problem["event.name"]}</Heading>
          <Text textStyle="small" color={problem["event.status"] === "ACTIVE" ? "critical" : "success"}>
            {getStatusLabel(problem["event.status"])}
          </Text>
        </Flex>
        <Flex gap={12} alignItems="center">
          <Text textStyle="small" color={getCategoryColor(problem["event.category"])}>
            {getCategoryLabel(problem["event.category"])}
          </Text>
          <Text textStyle="small-emphasized">
            {formatRelativeTime(problem["event.start"])}
          </Text>
        </Flex>
        {problem.display_id && (
          <Text textStyle="small">ID: {problem.display_id}</Text>
        )}
      </Flex>
    </Surface>
  );
};
