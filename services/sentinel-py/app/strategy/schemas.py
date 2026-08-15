from typing import Literal

from pydantic import BaseModel, Field


class StrategyRule(BaseModel):
    id: str
    name: str
    condition: str
    mandatory: bool
    description: str


class StrategyEntry(BaseModel):
    long: str | None = None
    short: str | None = None


class StrategyRiskManagement(BaseModel):
    stopLoss: str | None = None
    targets: list[str] = Field(default_factory=list)


class ParsedStrategy(BaseModel):
    """The structured rule set the deterministic parser produces from free
    text. Matches the `rules` JSON column on UserStrategy — no LLM, no
    inference beyond keyword/regex matching, so the same input always
    produces the same output."""

    timeframe: str | None = None
    levels: list[str] = Field(default_factory=list)
    rules: list[StrategyRule] = Field(default_factory=list)
    entry: StrategyEntry = Field(default_factory=StrategyEntry)
    riskManagement: StrategyRiskManagement = Field(default_factory=StrategyRiskManagement)


class ParseRequest(BaseModel):
    text: str


class ParseResponse(BaseModel):
    parsed: ParsedStrategy
    warnings: list[str] = Field(default_factory=list)


class CreateStrategyRequest(BaseModel):
    name: str
    rawInput: str
    inputType: Literal["text"] = "text"
    rules: ParsedStrategy


class UpdateStrategyRequest(BaseModel):
    name: str | None = None
    status: Literal["active", "paused", "archived"] | None = None
    rules: ParsedStrategy | None = None


class UserStrategyResponse(BaseModel):
    id: str
    userId: str
    name: str
    rules: ParsedStrategy
    rawInput: str | None
    inputType: str
    status: str
    createdAt: str
    updatedAt: str
