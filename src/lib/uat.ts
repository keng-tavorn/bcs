// S6-21 (BR-UAT-01): every e-mail of a UAT sandbox starts with "[UAT]", so nobody takes it for the real system's
export const uatSubject = (subject: string) => (subject.startsWith('[UAT]') ? subject : `[UAT] ${subject}`)
