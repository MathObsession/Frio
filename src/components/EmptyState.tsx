import { useState } from 'react';

const QUOTES: { text: string; author?: string }[] = [
  { text: "You don't have to be great to start, but you have to start to be great.", author: 'Zig Ziglar' },
  { text: 'The best time to plant a tree was twenty years ago. The second best time is now.' },
  { text: 'Done is better than perfect.' },
  { text: 'You can’t get rid of the fear of starting. You can only make starting a habit.' },
  { text: 'Discipline is choosing between what you want now and what you want most.' },
  { text: 'Just start. Momentum is built by motion, not by waiting.' },
  { text: 'One small step is still a step. You’re already moving.' },
  { text: 'Future you is watching right now. Make them proud.' },
  { text: 'Focus on the next right action, not the whole mountain.' },
  { text: 'Procrastination is a habit — and so is starting. Build the better one.' },
  { text: 'You will never feel ready. Start anyway.' },
  { text: 'A little progress each day adds up to big results.' },
  { text: 'Don’t wait for motivation. Act, and motivation will follow.' },
  { text: 'Be gentle with yourself. You’re doing better than you think.' },
  { text: 'Done today beats perfect someday.' },
  { text: 'Begin where you are. Use what you have. Do what you can.', author: 'Arthur Ashe' },
  { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
];

export function EmptyState() {
  const [quote] = useState(
    () => QUOTES[Math.floor(Math.random() * QUOTES.length)],
  );

  return (
    <blockquote className="quote">
      <p className="quote-text">“{quote.text}”</p>
      {quote.author && <cite className="quote-author">— {quote.author}</cite>}
    </blockquote>
  );
}
