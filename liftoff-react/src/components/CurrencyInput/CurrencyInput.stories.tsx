import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import CurrencyInput from './CurrencyInput'

const meta: Meta<typeof CurrencyInput> = {
  title: 'Components/CurrencyInput',
  component: CurrencyInput,
}
export default meta

type Story = StoryObj<typeof CurrencyInput>

function CurrencyInputDemo() {
  const [value, setValue] = useState('')

  return (
    <div style={{ maxWidth: 300 }}>
      <div className="form__row">
        <label className="form__label" htmlFor="currencyinput-stories-amount">Amount</label>
        <CurrencyInput id="currencyinput-stories-amount" value={value} onChange={setValue} />
      </div>
    </div>
  )
}

function CurrencyInputRowDemo() {
  const [a, setA] = useState('')
  const [b, setB] = useState('')

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="form__row-group">
        <div className="form__row form__row--flex">
          <label className="form__label" htmlFor="currencyinput-stories-dependents">Dependents</label>
          <CurrencyInput id="currencyinput-stories-dependents" value={a} onChange={setA} />
        </div>
        <div className="form__row form__row--flex">
          <label className="form__label" htmlFor="currencyinput-stories-other-income">Other Income</label>
          <CurrencyInput id="currencyinput-stories-other-income" value={b} onChange={setB} />
        </div>
      </div>
    </div>
  )
}

export const Default: Story = {
  render: () => <CurrencyInputDemo />,
}

export const SideBySide: Story = {
  render: () => <CurrencyInputRowDemo />,
}
