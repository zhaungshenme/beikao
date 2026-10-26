import type { QuestionResult, StudyQuestion, StudySession } from '@/api/study/types';

export interface StudyGradingResult extends QuestionResult {
  questionRevision: number;
  standardUpdated: boolean;
  snapshot: boolean;
}
const sameOptions = (left: string[], right: string[]) => {
  const expected = [...right].sort();
  return left.length === right.length && [...left].sort().every((id, index) => id === expected[index]);
};

/** Historical review must use its saved grading standard, never today's answer key. */
export function studyGradingResult(question: StudyQuestion, session?: StudySession | null, answerOverride?: string[]): StudyGradingResult {
  const graded = session?.status === 'completed' || session?.submittedQuestionIds.includes(question.id);
  const saved = graded ? session?.gradedResults?.[question.id] : undefined;
  if (saved) {
    const questionRevision = saved.questionRevision ?? 0;
    return {
      ...saved,
      answer: [...saved.answer],
      userAnswer: [...saved.userAnswer],
      questionRevision,
      standardUpdated: questionRevision !== (question.answerRevision ?? 0) || !sameOptions(saved.answer, question.answer) || saved.explanation !== question.explanation,
      snapshot: true,
    };
  }
  const userAnswer = [...(answerOverride ?? session?.answers[question.id] ?? [])];
  const expected = [...question.answer].sort();
  const selected = [...userAnswer].sort();
  return {
    questionId: question.id,
    correct: expected.length === selected.length && expected.every((id, index) => id === selected[index]),
    answer: [...question.answer],
    userAnswer,
    explanation: question.explanation,
    questionRevision: question.answerRevision ?? 0,
    standardUpdated: false,
    snapshot: false,
  };
}
