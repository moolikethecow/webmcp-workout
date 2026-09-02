import { redirect } from 'next/navigation'

/** The dashboard lands here later; for now the gym surface is the whole app. */
export default function HomePage() {
  redirect('/gym')
}
